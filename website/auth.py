from flask import Blueprint, render_template, request, flash, redirect, url_for
from .models import User
from werkzeug.security import generate_password_hash, check_password_hash
from . import db   ##means from __init__.py import db
from flask_login import login_user, login_required, logout_user, current_user


auth = Blueprint('auth', __name__)


@auth.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        email = request.form.get('email')
        password = request.form.get('password')

        user = User.query.filter_by(email=email).first()
        if user:
            if check_password_hash(user.password, password):
                flash('Logged in successfully!', category='success')
                login_user(user, remember=True)
                return redirect(url_for('views.home'))
            else:
                flash('Incorrect password, try again.', category='error')
        else:
            flash('Email does not exist.', category='error')

    return render_template("login.html", user=current_user)


@auth.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('auth.login'))


@auth.route('/sign-up', methods=['GET', 'POST'])
def sign_up():
    if request.method == 'POST':
        email = request.form.get('email')
        first_name = request.form.get('firstName')
        password1 = request.form.get('password1')
        password2 = request.form.get('password2')
        user_type = request.form.get('userType')

        user = User.query.filter_by(email=email).first()
        if user:
            flash('Email already exists.', category='error')
        elif len(email) < 4:
            flash('Email must be greater than 3 characters.', category='error')
        elif len(first_name) < 2:
            flash('First name must be greater than 1 character.', category='error')
        elif password1 != password2:
            flash('Passwords don\'t match.', category='error')
        elif len(password1) <= 0:
            flash('Password must be at least 7 characters.', category='error')
        elif user_type not in ['regular', 'commercial']:
            flash('Please select a valid user type.', category='error')
        else:
            new_user = User(email=email, first_name=first_name, user_type=user_type, password=generate_password_hash(
                password1, method='sha256'))
            db.session.add(new_user)
            db.session.commit()
            login_user(new_user, remember=True)
            if user_type == 'commercial':
                return redirect(url_for('auth.sign_up_commercial'))
            else:
                flash('Account created!', category='success')
                return redirect(url_for('views.home'))

    return render_template("sign_up.html", user=current_user)



@auth.route('/sign-up-commercial', methods=['GET', 'POST'])
def sign_up_commercial():
    if request.method == 'POST':
        # Extract address data from the submitted form
        address_data = request.form.get("address_data")
        
        # Parse the JSON string into a dictionary
        address_components = json.loads(address_data)
        print(address_components)
        # Create a new instance of the Commercial model with the address data
        # new_commercial = Commercial(
        #     location=address_components['location'],
        #     locality=address_components['locality'],
        #     administrative_area_level_1=address_components['administrative_area_level_1'],
        #     postal_code=address_components['postal_code'],
        #     country=address_components['country']
        # )

        # Add and commit the new instance to the database
        # db.session.add(new_commercial)
        # db.session.commit()

        # Redirect or flash a success message, as needed

    return render_template("sign_up_commercial.html", user=current_user)